/* ************************************************************************** */
/*                                                                            */
/*                                                        :::      ::::::::   */
/*   main.c                                             :+:      :+:    :+:   */
/*                                                    +:+ +:+         +:+     */
/*   By: ponzu <ponzu@student.42tokyo.jp>           +#+  +:+       +#+        */
/*                                                +#+#+#+#+#+   +#+           */
/*   Created: 2026/10/07 12:00:00 by ponzu             #+#    #+#             */
/*   Updated: 2026/10/07 12:00:00 by ponzu            ###   ########.fr       */
/*                                                                            */
/* ************************************************************************** */

#include <stdio.h>
#include <stdlib.h>
#include "str_utils.h"

int	main(int argc, char **argv)
{
	int		i;
	char	*copy;

	i = 1;
	while (i < argc)
	{
		copy = su_strdup(argv[i]);
		if (copy == NULL)
			return (1);
		printf("%s: %zu\n", copy, su_strlen(copy));
		free(copy);
		i++;
	}
	return (0);
}
