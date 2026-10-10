/* ************************************************************************** */
/*                                                                            */
/*                                                        :::      ::::::::   */
/*   main.c                                             :+:      :+:    :+:   */
/*                                                    +:+ +:+         +:+     */
/*   By: ponzu <ponzu@student.42tokyo.jp>           +#+  +:+       +#+        */
/*                                                +#+#+#+#+#+   +#+           */
/*   Created: 2026/10/08 12:00:00 by ponzu             #+#    #+#             */
/*   Updated: 2026/10/08 12:00:00 by ponzu            ###   ########.fr       */
/*                                                                            */
/* ************************************************************************** */

#include <stdio.h>
#include <stdlib.h>
#include "proj.h"

int	main(int argc, char **argv)
{
	char	*copy;

	if (argc < 2)
		return (0);
	copy = ft_strdup(argv[1]);
	if (copy == NULL)
		return (1);
	printf("%zu\n", ft_strlen(copy));
	free(copy);
	return (0);
}
